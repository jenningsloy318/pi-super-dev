# Spec-Track Reuse Absorption — Numeral Guard + Merge Close-Out (v0.3.12)

Status: implemented (this commit — v0.3.12)

## Incident (user-reported, code-verified)

The 06 run never got its own track: `findReusableSpec` absorbed it into the
already-merged 05 track, which then had its resume cache truncated (M11) and
both runs were cancelled.

Root-cause chain (each link verified in current `main`):

1. **Uniform task template** — every pi-omisis task reads
   `by referencing design docs/research/pi-omisis-master-design.md, implement
   docs/requirements/NN-*.md`; only the trailing filename distinguishes specs,
   so token-level similarity between ANY two specs is structurally high.
2. **The anchor-Jaccard branch has no numeral guard** (`src/setup.ts:246`):
   `reusableScore` fires at `taskSimilarity(anchor, task) >= 0.6` — measured
   **0.64** for the 05/06 pair. The R6 numeric-verbatim fix lives ONLY in
   `slugTokenContainment` (the containment branch); the slug's numeric prefix
   is stripped (`id.replace(/^\d+-/, "")`), so nothing numeric discriminates
   the Jaccard path. The shared template prefix drowns the one differing
   token (`05-independent-verification-gate` vs `06-ai-policy-enforcement`).
3. **Merged tracks never wrote `.complete`** — the only writer is
   `clearResumeCache` (`src/resume.ts:87`), called exclusively when
   `summary.status === "success"` (`src/pipeline.ts:46`). A merged run that
   cancels or ends `partial` at close-out leaves the track `isResumable`
   (cache non-empty, no marker) — a live reuse candidate forever.
4. Setup re-entered 05's worktree, truncated its resume cache (by-design M11
   truncation — catastrophic when the match itself was wrong), both runs died.

## Fixes

### F1 — spec-reference numeral guard on the anchor-Jaccard branch

`specRefNumerals(text)` extracts the leading numerals of path-like spec
references (`docs/…/NN-slug.md`, `NN-slug` tokens; `\b\d{1,3}(?=-[a-z0-9])`
within tokens containing `/`, `-`, or `.md`). In `reusableScore`, before the
Jaccard branch may fire: if the anchor's spec-reference numeral set is
non-empty and any of its numerals is absent from the task's set → **score 0**
(the same direction as the R6 slug rule: anchor numerals must appear verbatim
in the candidate task). A numeral-bearing spec reference is the one
unambiguous workstream discriminator under a uniform template; free-text
numerals (dates, ports, ticket ids) are deliberately NOT guarded — only
path-shaped `NN-` references — so re-phrasings that keep the spec file match.

`findReusableSpec` logs the refusal (`spec numeral 06 absent from anchor-set
…`) via the existing R6 score log, keeping wrong refusals visible.

### F2 — a git-confirmed merge writes `.complete` immediately

`merge-verify` (Stage 14B) already git-confirms the merge (ancestry, sha,
clean tree). When verification PASSES it now calls `clearResumeCache(specDir)`
— cache cleared + `.complete` written **at the moment of confirmation**, not
at summary time. A track merged to main is complete regardless of what the
close-out statuses later do (cancel, partial from an unrelated reason). The
`pipeline.ts` success-path call stays (idempotent; the marker check makes the
second write a no-op).

## Non-goals

- No change to the M11 truncation semantics (correct for genuine re-entry;
  the damage in this incident came from the wrong match, not the truncation).
- No broad numeral equality on free text (false-negative risk on re-phrasings
  that drop incidental numbers).

## Verification

- RED-first: T1 `05` anchor vs `06` task → null (pre-fix: matched 0.64);
  T2 identical anchors still match; T3 same-numeral re-phrasing still matches;
  T4 anchor with free-text numerals (no spec ref) unaffected by the guard;
  T5 merge-verify pass writes `.complete` + empties the cache in a real git
  fixture (pre-fix: no marker).
- Full suite + tsc.

## Review outcome

**Dual round 1** — code-reviewer *Changes Requested* (CR-1..4), adversarial
*Approved with Comments* (SKEPTIC/ARCHITECT/MINIMALIST echoes). All remediated:

- **CR-1** (medium): the anchor-numeral guard now gates EVERY reuse branch
  (containment included), not just Jaccard — a numeric-stripped slug plus an
  anchor naming a different spec is the same cross-workstream absorption.
- **CR-2** (medium): the path-shape regex only fabricates spec numerals from
  doc/spec-shaped paths (`docs|requirement|spec|research` segments); source
  paths like `src/254-e2e/…` no longer falsely refuse same-spec reuse.
- **CR-3/SKEPTIC-1** (low): refusals are LOGGED (`spec-track reuse: refusing
  track … numeral N absent …`) — the plan doc's promised visibility, now real.
- **CR-4/SKEPTIC-3** (low): `\d{1,4}` + zero-padding-stripped storage
  (`05` ≡ `5`, `0042` ≡ `42`).
- **MINIMALIST-1** (info): the coverage comment now states the two real shapes.

Four round-2 regression tests added (CR-1 containment refusal, CR-2 no-false-
refusal, CR-3 log assertion, CR-4 normalization). Final: tsc clean, 173 files /
2777 tests green.
