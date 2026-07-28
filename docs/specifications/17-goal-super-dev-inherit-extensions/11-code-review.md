# Code Review: Code Review: SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17)

- **Date**: 2026-07-22
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

The implementation matches the specification across all 9 acceptance criteria. The additive `inheritExtensions()` helper in src/pi-spawn.ts mirrors the established `SUPER_DEV_*` env-read idiom (`.trim()` + anchored `/^(1|true|yes|on)$/i`, short-circuit before `.trim()` so malformed/undefined input never throws). Both backends are wired in lockstep: session `noExtensions: !inheritExtensions()` (src/session-agent.ts) and subprocess `if (!browser && !inheritExtensions()) args.push("--no-extensions")` (src/pi-spawn.ts buildSpawnArgs). Default-OFF byte-identical baseline is confirmed by tests. `npm run typecheck` strict-clean (exit 0) and the targeted vitest run is green (pi-spawn 56, spec15 12, spec17 12 = 80/80). The CHANGELOG `[Unreleased] ### Added` bullet's bold span "Inherit extension-registered providers via SUPER_DEV_INHERIT_EXTENSIONS opt-in (spec-17)." carries the `inherit` anchor, satisfying both the existing spec-15 contract test and the new spec-17 test. Non-goals (safety factory, inheritedModelObject path, control-flow node algebra, resume cache, pipeline structure, zero-ANSI contract) are untouched per the diff. Findings are all Low/Info: one misleading comment in the opt-in path, over-verbose changelog prose, and a minor observability gap. No Critical/High/Medium issues.

## Findings

### F-01: buildSpawnArgs comment contradicts behavior when opt-in is ON

- **Severity**: Low
- **File**: `src/pi-spawn.ts`
- **Line**: 293
The expanded comment in src/pi-spawn.ts buildSpawnArgs states: "Research still loads ONLY its two extensions explicitly via `-e <path>` below ... so no other global extension is pulled in." This claim is only true in the default (`--no-extensions` present) path. When SUPER_DEV_INHERIT_EXTENSIONS is ON, `--no-extensions` is DROPPED for the non-browser branch, so the `pi --no-extensions -e ext` isolation pattern no longer applies and ALL ambient global extensions ARE loaded (which is the intended opt-in behavior). The comment as written is misleading for a maintainer reading the opt-in branch. Suggested fix: qualify the sentence, e.g. "Research still ADDS its two extensions via `-e <path>`; with the opt-in OFF this is the ONLY source (no other global extension is pulled in); with the opt-in ON ambient extensions are also discovered." Behavior itself is correct; documentation only.
### F-02: CHANGELOG bullet is far from the 'concise' the spec requested

- **Severity**: Low
- **File**: `CHANGELOG.md`
- **Line**: 10
The spec and goal both ask for a 'concise [Unreleased] CHANGELOG.md entry (### Added)'. The delivered bullet is a single ~650-word run-on sentence re-documenting internals (backend flags, precedence, the zero-ANSI contract, scenario coverage). Keep-a-Changelog Added sections conventionally summarize user-visible behavior in 1-2 sentences. The contract test only asserts the bold-span anchor `inherit` + env-var presence, so the verbosity is not required for compliance. Consider trimming to ~2 sentences (opt-in summary + trade-off note). No functional impact; pure maintainability/contract-hygiene.
### F-03: No observability signal when the opt-in is active (P2)

- **Severity**: Low
- **File**: `src/pi-spawn.ts`
- **Line**: 299
When SUPER_DEV_INHERIT_EXTENSIONS is ON, a spawned specialist loads a substantially different extension set (all user global + project extensions) than the byte-identical baseline, which materially affects model/provider/tool resolution and determinism. There is no log/debug line at either wiring point indicating the opt-in is active, so a user diagnosing why a child behaves differently has no trace. Suggested fix (optional): add a one-line debug/verbose log at the wiring points, e.g. `logger.debug?.('SUPER_DEV_INHERIT_EXTENSIONS: ambient extension discovery ENABLED for specialist')`. Consistent with the no-throw best-effort guard (guard with `if (logger.debug)`). P2 / non-blocking — the existing codebase pattern for the other SUPER_DEV_* toggles also lacks such logging, so this is a general gap, not a regression.
### F-04: New spec-17 changelog test file duplicates the spec-15 contract regex

- **Severity**: Info
- **File**: `tests/changelog-unreleased-spec17.test.ts`
- **Line**: 51
The implementation adds tests/changelog-unreleased-spec17.test.ts which re-declares the `boldBulletAnchored` regex and the `unreleasedSection` slicer from tests/changelog-unreleased-spec15.test.ts. This is acceptable (both pass) and gives spec-17 its own attributable coverage, but the duplicated contract logic will drift if the shared regex is updated in spec-15. Optional: extract the regex + slicer into a small shared helper (e.g. tests/_changelog-helpers.ts) so both tests reference one source of truth. Not required by the spec; informational only.
