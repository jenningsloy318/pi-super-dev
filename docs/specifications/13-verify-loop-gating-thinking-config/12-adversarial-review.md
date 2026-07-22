# Adversarial Review: Adversarial Review — Verify-Loop Gating & Per-Agent Thinking Config

- **Date**: 2026-07-22
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: CONTEST

---

Large change (~477 LOC across 8 files) implementing GAP A–D verify-loop gating in src/stages/verify.ts and per-agent thinking configuration in src/pi-spawn.ts / session-agent.ts / workflow.ts / types.ts. All three lenses applied. Verified independently: `npx tsc --noEmit` → 0 errors; the two new test files pass 20/20. Implementation faithfully mirrors the existing findingsSignature/reviewLoopUntil/__stagnated style, keeps every new loop-exit path non-fatal, preserves the max-3-round cap, and correctly wires reviewStageNode into stages/index.ts. No destructive/irreversible operations. No production-failure, data-loss, or security risk found, so this is not a REJECT. Verdict is CONTEST for a small set of medium/low behavioral concerns that merit an author response — chiefly the interaction between the new build-gate exit requirement (GAP B), the aggressive count-based stagnation trigger (GAP C), and the loop's until-checked-before-body semantics.

### F1: buildGreen() defaults to true when buildGate is unset, and until is evaluated before the body runs

- **Severity**: medium
- **Lens**: Skeptic
loop() in src/nodes.ts:281 evaluates `until` at the TOP of each iteration, before the body executes. On attempt 1 of reviewLoopNode, state.buildGate is still undefined, and buildGreen (src/stages/verify.ts:41-44) returns true for an undefined gate. GAP B's intent ('only exit when the deterministic build gate is green') is therefore silently satisfied on the first check without the gate ever running. This is currently harmless only because state.review is not Approved before Stage 10 produces it — i.e. safety rests on an implicit invariant, not on the code. If any upstream stage ever pre-populates state.review to an Approved verdict, the loop would exit on attempt 1 with a never-run build gate. Recommend making buildGreen require an explicitly-present green gate for the exit decision (e.g. treat undefined as not-yet-green in reviewLoopUntil), or assert the invariant.
### F2: GAP C count-based trigger can flag legitimate slow convergence as stagnant

- **Severity**: medium
- **Lens**: Architect
detectStagnation (src/stages/verify.ts) returns true whenever cur>0 && prev>0 && cur>=prev. A real, slow-but-progressing loop that fixes N findings each round while the re-review surfaces N genuinely-new real defects of equal count (5→5 with entirely different signatures) is indistinguishable from oscillation and bails after only 2 rounds. Combined with GAP B (which now KEEPS looping on approved+build-red), the count trigger becomes the dominant early-exit and may abandon runs that would have gone green on round 3. This behavior is explicitly requested by the spec ('5→5 = scope drift'), so it is intentional, but the author should confirm the tradeoff is acceptable given the max cap is only 3 — the count trigger effectively reduces the usable budget to 2 rounds for any non-strictly-decreasing sequence.
### F3: Stage 11 stagnation history is seeded from state and never reset per node entry

- **Severity**: low
- **Lens**: Skeptic
integrationLoopNode reads __testSignatures/__testCounts from state with `?? []` and only initializes when absent. If the node is ever re-entered within a run (or state carries stale history), the new round's signatures append to the old history and could trip detectStagnation on the very first retry against a prior run's signature. In the current single-pass pipeline this cannot happen, so risk is low, but a defensive reset at node entry (or a comment documenting the single-entry assumption) would harden it. Same latent concern applies to __reviewSignatures/__reviewCounts, though reviewLoopUntil is only driven inside one loop.
### F4: detectStagnation mutates its input arrays while returning a boolean

- **Severity**: low
- **Lens**: Architect
detectStagnation pushes onto sigHist/countHist (side effect) and returns a verdict, blending a command and a query. Callers (reviewLoopUntil and recordTestStagnation) rely on this push side effect to grow the persisted history. It works and is tested, but the dual role is a mild readability/maintenance smell for a function named like a pure predicate. Consider renaming (e.g. pushAndDetectStagnation) or splitting record/detect for clarity.
### F5: Invalid SUPER_DEV_THINKING and setThinkingLevel failures are silently ignored

- **Severity**: low
- **Lens**: Skeptic
asThinkingLevel (src/pi-spawn.ts) silently discards an unrecognized env value and falls back to the role default with no log — a typo like SUPER_DEV_THINKING=hgih is silently ineffective. Likewise applyThinkingLevel (src/session-agent.ts) swallows all throws with an empty catch and no diagnostic. Both are per-spec 'best-effort', but a single ctx-level debug log on the invalid-env and on the caught throw would make misconfiguration and runtime-clamping observable instead of invisible.
### F6: Redundant per-value threading of thinking / thinkingLevel and unused level ordering

- **Severity**: low
- **Lens**: Minimalist
workflow.ts threads the single call.thinking value into TWO differently-named fields (thinking and thinkingLevel) so each backend can read its own option name; pragmatic but a duplicated source of truth. Separately, THINKING_LEVELS is documented 'least→most effort' but no code consumes that ordering (only membership is checked), so the ordering contract is decorative. Neither is worth blocking on; consolidating to one option name at the SpawnAgentOptions/SessionAgentOptions boundary would remove the duplication.
