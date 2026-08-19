# Requirements — v0.2.8: no artifact may reference a non-existent thing (prevent · detect · cure)

Status: analysis & plan
Type: feature (harness hardening)
UI scope: arch (fault routing + agent prompts; no UI)
> Shipped in v0.2.8: G1–G4. G5 (per-phase record docs) and G6 (phase-scoped test
> runs + baseline-runner parity) are deferred to v0.2.9 — G5 needs a systemic
> "change tracker ignores the harness spec dir during the phase window" fix and
> G6 is an independent build-runner scoping change.
Source of failure: run `~/.super-dev/runs/2026-08-19T08-32-47-962Z/run.log` (phase 1 RED, 7 tries)
Affected: `src/stages/judge.ts`, `src/prompts.ts`, `src/stages/implementation.ts`,
`agents/requirements-reviewer.md`, `agents/bdd-reviewer.md`, `agents/spec-reviewer.md`
Current version: `0.2.7` → target `0.2.8`

## 1. Executive summary
Run `08-32-47` looped phase-1 RED for 7 tries and could not converge because **AC-01
mandated preserving an "existing direct-REST STEP connection type/schema/routes/contract"
that does not exist in the codebase** (confirmed: zero `"STEP"` connection-type constants
in backend Go outside the new `stepmcp` stubs). The RED strength reviewer correctly kept
demanding SCENARIO-001 bind that "existing" contract to concrete unchanged values; the
tdd-guide correctly could not find any such contract to bind. Neither side could satisfy
the other → livelock. The judge (v0.2.5/v0.2.6 working) routed `re-author-tests` with the
right diagnosis, but re-authoring cannot create a baseline that does not exist.

Root class: **a downstream/upstream artifact references something that does not exist** —
here a requirement asserting a non-existent code baseline; generally, BDD minting an AC
absent from requirements, or a spec citing a non-existent BDD scenario / requirement AC /
code entity. Three defenses, three layers:

## 2. Fixes

### G1 — Cure (harness): red-no-progress replan route
- `judge.ts`: add `replan-upstream` to `JUDGE_ROUTES`. It is **evidence-REQUIRED** (NOT in
  `DIAGNOSIS_DRIVEN_MISSING_OK`): the claim "an upstream artifact is defective" is
  consequential (it re-runs upstream stages), so the judge must quote the offending
  AC/scenario and the contradicting reality; a zero-evidence `replan-upstream` DISCARDS
  (→ HITL fallback), preserving the fabrication guard.
- `prompts.ts` `buildJudgePrompt`: add a route gloss for `replan-upstream`.
- `implementation.ts` red-no-progress site: widen `allowedRoutes` to
  `["re-author-tests","fix-environment","replan-upstream"]`; a routed `replan-upstream`
  builds a finding from the judge diagnosis + evidence and calls the existing
  `triggerReplanForFindings(state, ctx, [finding], "implementation-red", specIdentifier)`
  so the run ends `replan` and auto-resumes at the owning upstream stage (requirements/
  spec/bdd). If not routable / replan budget exhausted (`false`), fall through to today's
  HITL escalation carrying the judge diagnosis. Never throws.

### G2 — Prevention (writer prompts)
- `buildRequirementsPrompt`: any AC that asserts an EXISTING code entity/contract/route/
  schema ("preserve the existing X unchanged", "extend the current Y") MUST be grounded
  against the actual codebase (source-read-only); if the referenced baseline is absent,
  do NOT assert it as existing/preserved — treat the capability as new/greenfield or
  record it in `openQuestions`. (Directly prevents the AC-01 class.)
- `buildBddPrompt`: reinforce — never mint an AC-NN; every `acRef` must name an AC that
  EXISTS in requirements; a needed-but-missing AC is a requirements gap to SURFACE, not to
  invent. (Backstopped by `bddTraceabilityErrors`.)
- `buildSpecPrompt`: reinforce — every `SCENARIO-NNN`/`AC-NN` referenced must EXIST in the
  BDD/requirements docs, and every code reference must be grounded; never invent an upstream
  id. (Backstopped by `specTraceabilityErrors` + grounding.)

### G3 — Detection (reviewer enforcement)
- `requirements-reviewer.md`: add **D7 Existence grounding (BLOCKING)** — any AC asserting
  an EXISTING code baseline/contract/entity must be verified against the actual codebase;
  an AC referencing a non-existent baseline is a blocking finding (`ownerStage: requirements`).
  This is the missing dimension that would have caught AC-01.
- `bdd-reviewer.md`: reinforce D1 — a scenario `acRef` to a non-existent AC, or an AC minted
  in the BDD doc but absent from requirements, is blocking (`ownerStage: requirements` if the
  AC is genuinely needed but missing upstream; `bdd` if invented).
- `spec-reviewer.md`: reinforce D5/D6 — a spec referencing a non-existent BDD SCENARIO,
  requirement AC, or code entity is blocking.

### G4 — Unblock RED: declaration-only scaffolding, judge-arbitrated
The RED "test-only" discipline conflicts with compiled languages, where a test that
references an undefined symbol fails to COMPILE (`broken`) instead of failing on its
assertion (`red`) — the run's tries 1/3/5. Fix, three parts, oracle-guarded:
- **Enable (prompt):** the tdd-guide MAY create NEW declaration-only scaffolding + test
  fixtures — types/interfaces/consts/enums and function SIGNATURES with unimplemented
  bodies (`panic`/not-implemented/zero-return) — so the test compiles and fails RED. It
  MUST NOT implement the behavior under test, and MUST NOT modify EXISTING production
  files. It DECLARES a `scaffoldPlan` `[{path, kind, reason, specRef}]` in its output.
- **Classify (boundary):** `red-boundary-classifier` gains a `scaffold` category
  (new declaration-only production skeleton) that is ALLOWED, distinct from `production`
  (real behavior — still forbidden).
- **Arbitrate (judge, on demand):** when the boundary is `ambiguous`/production-suspected
  OR the RED loop stalls, the judge is offered `allow-scaffold`: it reads the spec/BDD +
  the files and, evidence-backed, blesses a spec-justified declaration-only scaffold
  (approved paths are allow-listed and the loop retries) or routes
  `re-author-tests`/`replan-upstream`/`escalate-now`.
- **Oracle guard (unchanged, the true safety net):** after any allowance the test MUST
  still be `red`; a scaffold that implemented behavior flips `green` and is rejected
  (green-weak). Neither the prompt nor the judge can manufacture a false RED.

## 3. Acceptance criteria
- AC-1: `replan-upstream` is a `JUDGE_ROUTES` member and is NOT missing-evidence-exempt (a
  zero-evidence `replan-upstream` DISCARDS; an evidence-backed one ROUTES).
- AC-2: At red-no-progress the judge is offered `replan-upstream`; a routed one attempts the
  replan circuit and, when not routable, falls through to HITL (never throws, never deadlocks).
- AC-3: The requirements/bdd/spec writer prompts carry the grounding/traceability discipline.
- AC-4: The judge prompt lists a `replan-upstream` gloss.
- AC-5: The requirements-reviewer gains an existence-grounding blocking dimension; bdd/spec
  reviewers explicitly flag non-existent upstream/code references as blocking.
- AC-6: `allow-scaffold` is a `JUDGE_ROUTES` member (evidence-required); the boundary
  classifier exposes a `scaffold` allowed category; the tdd-guide prompt permits
  declaration-only scaffolding + fixtures and forbids implementing behavior / editing
  existing production.
- AC-7: Existing judge, red-loop, prompt, and traceability tests stay green; version
  0.2.7→0.2.8.

## 4. Non-functional
- NFR-1: No new deadlock source — `replan-upstream` is bounded by the judge per-signature
  budget AND the replan round budget; a non-routable verdict degrades to HITL.
- NFR-2: The fabrication guard is preserved (evidence-required route).
- NFR-3: Version bump 0.2.7→0.2.8 across `src/version.ts`, `package.json`, `package-lock.json`
  (root+node only), `tests/version.test.ts`, regenerated `docs/ARCHITECTURE.md`, CHANGELOG.
