# Specification Review: Spec-17 Review: SUPER_DEV_INHERIT_EXTENSIONS opt-in

- **Date**: 2026-07-22
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

Well-grounded, minimal, additive spec. The opt-in design (single exported helper `inheritExtensions()` + two lockstep wiring flips) is correctly reasoned to be byte-identical to current behavior when unset/falsy, and every load-bearing codebase reference verified against the actual repo — session-agent `noExtensions: true`, pi-spawn `if (!browser) args.push("--no-extensions")`, the `resolveModel`/`asThinkingLevel` helper cluster, the `saveEnv` test harness, the `isBrowserAgent` branch, and the `changelog-unreleased-spec15.test.ts` anchor regex (incl. the `inherit` token). Grounding score ~95% (no HIGH). The parsing regex, truthy/falsy token set, browser-invariance argument, and no-throw guard are all explicit and correct. Two MEDIUM gaps block a clean APPROVE: (1) the session-backend wiring (`runAgentViaSession` / `DefaultResourceLoader`) has NO automated test by the spec's own admission — coverage rests on manual diff review, so a silent regression reintroducing `noExtensions: true` on the session path would not be caught; (2) SCENARIO-014 is unmapped anywhere in the spec and SCENARIO-009 is cited only in inherited-model code comments belonging to a different feature, leaving the traceability chain incomplete for those two scenarios. Verdict: APPROVED WITH REVISIONS — the change is safe to land, but close the testability/traceability gaps before the final quality gate.

## Findings

### F-01: Session-backend wiring has no automated test coverage

- **Severity**: medium
Testing Strategy §(3) explicitly waives a `runAgentViaSession` / `DefaultResourceLoader` unit test, leaving the `noExtensions: !inheritExtensions()` flip (session-agent.ts:487) covered only by a manual diff review (asserted 'via phase deliverables'). The subprocess wiring is unit-tested but the session wiring is not. A future edit that silently reintroduces `noExtensions: true` on the session path would pass `npm test`. Recommendation: either (a) stub `SettingsManager`/agentDir/cwd to assert `noExtensions === false` under `SUPER_DEV_INHERIT_EXTENSIONS=1` and `=== true` when unset; or (b) extract the loader-options object into a pure `buildLoaderOptions(opts, inherit)` builder and unit-test it directly, keeping `runAgentViaSession` thin. The spec's justification (loader 'not trivially isolatable') is reasonable for a default-OFF opt-in but does not eliminate the regression risk for one of two lockstep wirings.
### F-02: SCENARIO-014 unmapped; SCENARIO-009 cited only under a different feature

- **Severity**: medium
The Testing Strategy explicitly maps SCENARIO-001/002/003/004/005/006/010/011/012/013/015/016 to concrete tests or the diff-review gate. SCENARIO-014 is not mentioned anywhere in the spec. SCENARIO-009 appears only inside inherited-model code comments (Phase 1 / Feature 1), which is a separate feature this spec explicitly lists as a non-goal. Because the BDD scenario definitions were not supplied for review (Plan/Tasks marked N/A), the SCENARIO-014 → behavior/test chain cannot be verified as unbroken. Recommendation: add an explicit SCENARIO-014 → test/behavior mapping in the Testing Strategy, or state clearly which existing gate satisfies it.
### F-03: AC definitions and BDD scenario bodies are external to this document

- **Severity**: low
AC-01..AC-09 and the 16 BDD scenario bodies live in requirements/acceptance-criteria artifacts that were not provided for this review (Plan: N/A, Tasks: N/A). The spec references them by ID only ('All 9 ACs / 16 BDD scenarios are addressed'). A full AC→spec-section coverage matrix cannot be reconstructed from this document alone. Recommendation: confirm the requirements/AC artifacts exist in the spec directory and add a cross-link table (AC-nn → spec section) so the traceability chain is self-contained.
### F-04: Cross-spec coupling on the spec-15 CHANGELOG contract test

- **Severity**: low
The feature's quality gate depends on `tests/changelog-unreleased-spec15.test.ts` (a spec-15 artifact) whose anchor regex token set `inherit|model|thinking|constrain|structured-output|registerEntryRenderer|PI_SESSION_ID|PI_MODEL` happens to match this feature's `inherit` token. spec-17's gate is therefore coupled to spec-15's test file remaining unchanged and to the bold-bullet ordering being preserved. The spec acknowledges this ('no previously-matched anchor/bullet may be removed or reordered'), but a future spec-15 edit could silently break spec-17's gate. Recommendation: add a comment in the spec-15 test documenting that `inherit` also anchors spec-17, or add a spec-17-local assertion so the dependency is explicit rather than incidental.

## Dimension Reviews

### D1 Completeness

- **Status**: warn

Error handling, NFRs (additive/default-OFF/byte-identical), and most scenarios are covered, but SCENARIO-014 has no mapping and the AC/SCENARIO bodies are external (artifacts N/A). Score ~3/5.
### D2 Consistency

- **Status**: pass

Names, env var, helper signature, and terminology (noExtensions / inheritExtensions / SUPER_DEV_INHERIT_EXTENSIONS) are uniform across Summary, Architecture, and Testing Strategy. Browser-invariance argument consistent with isBrowserAgent code. Score 5/5.
### D3 Feasibility

- **Status**: pass

Fits existing patterns: helper mirrors the resolveModel/asThinkingLevel idiom; both wiring sites verified present in repo; single-file import path already exists between session-agent.ts and pi-spawn.ts. No circular deps, no new stack capability required. Score 5/5.
### D4 Testability

- **Status**: warn

Parsing unit test and buildSpawnArgs flag-presence test are concrete and reuse the saveEnv harness. But the session-backend wiring has NO automated test (spec §3 waives it). Numeric thresholds implicit (toContain/not.toContain). Score 3/5.
### D5 Traceability

- **Status**: warn

Most SCENARIO→test mappings explicit, but SCENARIO-014 unmapped and SCENARIO-009 only in unrelated code comments. AC→spec matrix not reconstructable (ACs external). Cross-spec CHANGELOG-test coupling (F-04). Score 3/5.
### D6 Grounding

- **Status**: pass

~95% verified: session-agent noExtensions:true (~487) ✓, pi-spawn `if(!browser) push --no-extensions` (~276) ✓, resolveModel/resolveThinking/asThinkingLevel cluster (~155-185) ✓, saveEnv harness + beforeEach/afterEach (~194/246-249) ✓, changelog-unreleased-spec15.test.ts regex line 101 with `inherit` token ✓, isBrowserAgent line 32 ✓. Above the 90% gate. Only `asBackend`/SUPER_DEV_BACKEND existence not directly confirmed (minor, non-load-bearing). Score 5/5.
### D7 Complexity

- **Status**: pass

Minimal additive change: one helper + two one-line flips + comments + focused tests. Simplest viable approach; no premature abstraction, no YAGNI violations. Non-goals (safety factory, inheritedModelObject, control-flow node algebra, resume cache) explicitly excluded. Score 5/5.
### D8 Ambiguity

- **Status**: pass

Signature, regex, exact truthy token set (1|true|yes|on, case-insensitive, trimmed), falsy set (unset/empty/0/false/garbage→OFF), browser-invariance in both states, and byte-identical baseline are all stated explicitly. Determinism trade-off (no self-trigger because spawned agents get no interactive input) documented at both wiring points. Score 5/5.
