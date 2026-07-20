# Adversarial Review: Adversarial Review — Cargo Package-Name Resolution (spec-07)

- **Date**: 2026-07-20
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: CONTEST

---

The implementation correctly resolves the framework bug: `detectTouchedCargoPackages` now maps touched directory segments to REAL cargo package names via a cached, never-throwing `resolveCargoPackageNames` → `loadCargoMetadata` (`cargo metadata --no-deps`, discrete-argv spawn under the existing timeout envelope, per-cwd cache, failure sentinel). The fallback chain (empty→[], metadata-fail→identity, unmatched-element→identity, throw→identity) is sound and preserves backward compat (dir==name is identity; non-rust repos never reach the resolver because `runBuildGate` gates on `language === "rust"`; `npm run typecheck` is strict-clean). Fix 3 adds a Rust no-`--lib` verification discipline to implement/QA prompts. Typecheck passes.

However, the matching model has a real correctness gap (Finding 1): when two workspace members share the same first `crates/<seg>/` segment (e.g. `crates/data/core` + `crates/data/io` as distinct packages), the touched-set regex captures only `data` and `meta.packages.find(...)` silently selects whichever package cargo lists first — order-dependent, possibly non-deterministic, and not necessarily the touched crate. This is the same *class* of bug being fixed (wrong `-p` name → cargo reject or wrong-crate green), so it warrants an author response, though it degrades to the documented first-segment design rather than crashing. Supporting concerns: an unconditional (not language-scoped) prompt broadcast, a duplicated regex literal, and a cache-staleness assumption on worktree path reuse. No production-failure/data-loss/security issue → CONTEST, not REJECT.

### ADV-01: Multi-crate-per-top-segment matching is ambiguous and order-dependent

- **Severity**: medium
- **Lens**: Skeptic
resolveCargoPackageNames (src/build-runner.ts ~385) selects each touched package via `meta.packages.find((p) => firstCratesSegment(p.manifestDir) === d)`, and the touched-set extraction regex `/(?:^|\|/)crates\/([^/]+)\//` captures ONLY the first segment. If a workspace nests distinct crates under one top segment — e.g. `crates/data/core/Cargo.toml` (pkg `stockfan-data-core`) + `crates/data/io/Cargo.toml` (pkg `stockfan-data-io`) — a touch to `crates/data/io/...` collapses to segment `data`, and `find()` returns whichever member cargo lists first (cargo `packages[]` order is not guaranteed to be directory order). Result: the gate may emit `-p stockfan-data-core` (wrong crate) or, at minimum, silently picks one of two valid crates non-deterministically. This is the same failure class as the original bug (wrong `-p` → cargo reject, or a wrong-crate green that hides the real regression). Fix options: (a) match on the touched FILE's full path prefix against each package's manifestDir rather than the collapsed first segment; or (b) when multiple packages match a segment, include ALL of them. At minimum, document this limitation and assert it in tests. src/build-runner.ts:385, src/build-runner.ts:173.
### ADV-02: Cache keyed by absolute cwd assumes path-immutability across a long-lived process

- **Severity**: low
- **Lens**: Skeptic
`cargoMetadataCache` is module-level, keyed by `resolve(cwd)`, and cleared only by process exit or `vi.resetModules()`. Worktree-based workflows (pi itself) routinely delete and recreate worktrees at the SAME absolute path inside one long-lived pi process — a run after a worktree recreate would be served a stale `ok:true` result reflecting the OLD package set (renamed/removed members invisible), yielding wrong `-p` names. The spec accepts 'process-local — never across runs (stale risk)', but a single pi process can host multiple runs at the same path. Recommend an explicit cache-invalidation hook on worktree create/destroy, or a TTL, or documenting that the cache assumes path-immutability within a process. src/build-runner.ts:158.
### ADV-03: cwd implicitly assumed to be the workspace root via --manifest-path

- **Severity**: low
- **Lens**: Skeptic
loadCargoMetadata passes `--manifest-path join(cwd, 'Cargo.toml')`. If the gate is ever invoked with cwd pointing at a sub-crate (not the workspace root), `cargo metadata` returns only that member's view → other touched segments fall through to identity → wrong `-p` flags → the original cargo rejection can recur. Cargo auto-discovers the workspace root by walking up from cwd, so the explicit `--manifest-path` is both redundant and stricter (fails if the root manifest lives at a parent or has a different name). Dropping `--manifest-path` and using cwd alone would be strictly more robust. src/build-runner.ts:235.
### ADV-04: Identical crates-segment regex duplicated in two places

- **Severity**: low
- **Lens**: Architect
`CRATE_SEGMENT_RE = /(?:^|\|/)crates\/([^/]+)\//` is defined at module scope (src/build-runner.ts:139) AND re-declared inline as `const re` inside `detectTouchedCargoPackages` (src/build-runner.ts:173). A code comment asserts they are 'identical', but they are maintained separately — a future change to segment extraction must update both or the resolver's notion of a segment will silently diverge from the gate's touched-set extraction, producing name/dir mismatches. Consolidate to one shared exported (or module-private) constant used by both firstCratesSegment and detectTouchedCargoPackages.
### ADV-05: Fix 3 prompt discipline broadcast to ALL languages, not language-scoped

- **Severity**: low
- **Lens**: Minimalist
Phase 3 of the spec called for a 'language-scoped rust verification discipline'. The implementation appends `RUST_SELF_VERIFY_DISCIPLINE` UNCONDITIONALLY to `buildImplementPrompt` and `buildQaPrompt`, relying on prose wording ('When verifying a Rust crate…') to scope it. Every Go/Python/TS/frontend implementation and QA run now carries a `cargo test -p <pkg>` instruction — irrelevant token overhead on every non-rust run and a small risk of nudging a non-rust agent toward cargo commands. The builders already thread `langInstructions`/language; gate the discipline on `language === 'rust'` there (or fold it into the existing language-instructions path) instead of unconditional append. src/prompts.ts:93-104.
### ADV-06: Fallback dedup logic duplicated across two branches

- **Severity**: low
- **Lens**: Minimalist
In resolveCargoPackageNames, the `!meta.ok` branch and the top-level `catch` branch both construct `dedupePreservingOrder(touchedDirs.filter((d): d is string => typeof d === 'string'))` verbatim (and the catch branch also re-checks `Array.isArray`). Extract a single local helper (e.g. `const identity = (xs) => dedupePreservingOrder((Array.isArray(xs)?xs:[]).filter(isString))`) and return it from both, removing the duplication and the double Array.isArray guard. src/build-runner.ts ~355-395.
### ADV-07: Heavy multi-paragraph JSDoc on module-private helpers

- **Severity**: info
- **Lens**: Minimalist
firstCratesSegment, loadCargoMetadata, and resolveCargoPackageNames each carry multi-paragraph JSDoc (good for reviewability and the spec's auditability goal, but disproportionate for module-private helpers and ~120 of the ~200 added lines are comments). Not harmful; noting only so the author can trim if token/line budget matters elsewhere. No action required.
