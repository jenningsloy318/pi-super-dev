# Contract-Claims Layer — v0.3.2

Status: implemented (this commit — v0.3.2)

Grounding: the WS-1 design from the research synthesis (RSI survey §5.2
verification hierarchy — "wherever a checker exists, refinement is rebuilt
around it"; Self-Correction Illusion — addressability; pre-execution
structural checks catch inter-tool contract violations) + the
reference-repos full read (deepseek-harness's verify-type-equiv family:
claims artifacts make about code are checked mechanically, never by
reviewer goodwill; dsh's reviewer/gate division of labor) + the run
2026-08-20T06-19-50-494Z evidence: the filename-allowlist defect class was
machine-checkable from round 1 (enumerate registry values × derive
filenames × match against the declared pattern — pure computation), yet no
checker ran it and 3 review rounds discovered it one site at a time.

v0.3.0 philosophy intact: these are DETERMINISTIC sensors (rung 2) that
produce retry feedback through the existing gate machinery — no judge, no
arbitration, no new loops. v0.3.1's F2 derivation rule told writers to
enumerate; v0.3.2 gives the enumeration a machine-checked home.

## C1 — Design contract-claims block + deterministic checker (the flagship)

- `DesignData` gains `contracts?: Array<{name, pattern, enumerates[],
  sourceAnchor, derivationRule, uniqueness?}>` and
  `alternativesConsidered?: Array<{decision, chosen, rationale,
  alternatives?}>` (dsh Agent-Notes lesson: a decision recorded without
  what it beat invites reviewer re-litigation).
- `design.md.njk` renders a `## Contract Claims` section (per contract:
  name, pattern, derivation rule, source anchor, the FULL enumerated
  closure table) and an `## Alternatives Considered` section — the
  run-2026-08-12 lesson (control carried data the template never rendered,
  reviewer saw nothing, loop spun) means the render is checked, not
  assumed.
- New `designContractsErrors(control, worktreePath)` in doc-validators.ts:
  1. every `pattern` compiles as a regex (invalid regex → its error);
  2. closure consistency: EVERY enumerated value matches its own pattern —
     ALL violations reported at once as a table (the run-06-19 kill: round
     1 names every filename family, not one);
  3. `sourceAnchor` (repo-relative path, optional `#export` suffix) — the
     path exists under the worktree root (no `..` escape) and, with a
     suffix, the file text contains the export name at a word boundary
     (the cheap verify-type-equiv: anchors cite reality);
  4. `uniqueness: true` claimed → no duplicate enumerated values.
- New `designComplete` ArtifactValidator wired into `designConvergenceNode`
  (the stage currently has NO deterministic gate): runs
  `designContractsErrors` on the design control AND verifies the rendered
  design doc carries the `## Contract Claims` heading when the control
  declares contracts. Empty/absent contracts pass unchanged
  (backward-compatible; the design prompt demands the block only when the
  design states paired generate/validate contracts).

## C2 — Spec deliverables pre-flight (fail at spec time, not phase-GREEN)

`deliverablesPreflightErrors(phases, bddContent)` wired into
`gate-spec-trace` (after the BDD doc is read):
- every `requireContains`/`requireNotContains` pattern compiles as a regex
  (a malformed pattern is a perma-fail deliverable that only surfaces at
  phase-GREEN today);
- every `requireScenarios` SCENARIO-NNN id exists in the BDD doc (a
  deliverable pinned to a non-existent scenario can never go green);
- `requireFiles`/`requireContains[].file` paths are repo-relative with no
  `..` escape;
- `requireTests` entries are non-empty strings.

## C3 — BDD boundary lint (the BDD-F01 class, mechanically)

`bddBoundaryLintErrors(requirementsContent, bddContent)` wired into
`gate-bdd`: every numeric bound pinned in an AC statement
(at most / at least / no more than / up to / exactly / top / first /
within / max / min / limit of N) must appear as a literal number somewhere
in the BDD doc (digit-normalized: `1,000` ≡ `1000`). A boundary no
scenario names cannot be exercised — the error demands a scenario at the
boundary. Tight guards keep false positives out: only explicit
bound-phrases, only AC-statement lines, digits normalized on both sides,
at most 4 reported.

## C4 — AC `verifiedBy` classification (groundwork)

`AcceptanceCriterion` gains optional
`verifiedBy: "deterministic" | "test" | "manual"`; the requirements prompt
asks for the classification; the template renders it inline
(`(verified by: deterministic gate)`). Consumption (spec deliverable
mapping hints) is deliberately deferred — no behavior change this version.

## Reviewer division of labor (dsh lesson)

One shared line in `buildUpstreamReviewPrompt`: when the artifact carries
a Contract Claims block, the deterministic checker owns
pattern-vs-enumeration closure and anchor existence — the reviewer instead
verifies the ENUMERATION MATCHES REALITY (read the cited source) and
judges the derivation rule. Reviewer attention goes where nothing else
checks.

## Non-goals

No structural comparison of quoted type declarations against compiled
source symbols (full verify-type-equiv — v0.3.3+ candidate); no cross-run
defect-class ledger (separate slice); no forcing the contracts block on
designs that state no paired contracts; no judge changes.

## Verification plan

RED-first (`git stash src/`): the C1 closure/anchor/regex/render tests,
C2 pattern/scenario/path tests, C3 boundary tests, C4 schema/template
tests, and the design-loop wiring test must fail on pre-fix code;
backward-compat controls (design with no contracts passes; BDD with the
boundary named passes; deliverables well-formed pass) are green on the
post-fix tree — pre-fix the file cannot import (whole-file RED). Full
suite + tsc. Version bump set 0.3.1 → 0.3.2 with CHANGELOG + arch regen.
Dual code-reviewer + adversarial-reviewer, remediate, commit.


## Review outcome (dual systematic review)

Both APPROVED WITH COMMENTS; all findings remediated.

Adversarial — F1 (P2): comma-grouped bound capture truncated ('10,000' →
'10') and raw substring containment let small bounds be satisfied by
'SCENARIO-100' → the capture now takes the full grouped number with an
optional unit suffix (ms/s/min/h/kb/mb/gb/%/x), BOTH sides are
digit-normalized, and containment is a digit-boundary regex; F2 (P2): a
declared contract with a vacuous enumeration passed silently → an explicit
error (empty array, or all entries non-string/blank); F3: JS-literal-style
patterns ('/^x$/i') compile-but-match-nothing → targeted dialect error;
F4: silent slice(0,12) → announced truncation; F5: the v0.3.1 derivation
sentence was redundant with the stronger contracts paragraph in the design
prompt → removed from design (kept in spec, which has no contracts block);
F6: parity-skip and #export-boundary tests added, backward-compat wording
corrected.

Code-reviewer — C1-WIRING-UNTESTED (P2): node-level regression test added
(designConvergenceNode carries the closure table into every round's writer
feedback); C1-EMPTY-ENUMERATES (P2): same vacuous-enum fix; C2-REGEX-DIALECT
(P2): the preflight now ACCEPTS '(?i)' prefixes (parity with the
phase-GREEN tolerantMatch consumer); C2-SCENARIO: pins normalize with the
same padding rule as extractScenarioIds; C3-AC-SIDE/SUBSTRING: folded into
the F1 rewrite; C1-EXPORT: identifier-boundary lookarounds replace \b;
C2-NOTCONTAINS-NO-FILE: flagged at spec time; STALE-COMMENTS: both "no
deterministic gate" comments updated; C4-VERIFIEDBY: capitalized forms
accepted. Suite: 28 tests in the v0.3.2 file.
