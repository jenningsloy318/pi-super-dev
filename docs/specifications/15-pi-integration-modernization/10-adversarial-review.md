# Adversarial Review: Adversarial Review — pi Integration Modernization (spec-15): main-session model/thinking inheritance, constrained structured_output sampling, typed registerEntryRenderer, bash session-env build tagging

- **Date**: 2026-07-28
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: CONTEST

---

The change set is safe and well-disciplined: 1515 tests pass, typecheck is clean, no destructive actions (no DROP/rm-rf/force-push), no NEW `as unknown as` casts (the registerEntryRenderer cast is correctly removed), and the no-throw/best-effort + zero-ANSI contracts are honored. Feature 1 (model/thinking inheritance) is the headline win and is genuinely well-built: precedence chains are correct on both backends, the double-application guard for thinking is sound, and the additive/non-clobbering discipline holds. However, two of the five features ship in an INERT state that the acceptance criteria don't actually exercise in production: (a) Feature 2's `constrainedSampling` machinery is complete and unit-tested, but NO pipeline stage schema is strict-capable, so it never activates in a real run — the corrective re-prompt remains the only active path, exactly as today; (b) Feature 4's `correlation` tag is written into an in-memory `BuildGateResult` field that nothing reads, serializes, or logs, so parallel-run correlation — its entire purpose — is not observable. These are adoption/completeness gaps, not production failures (behavior is byte-identical to today), so the verdict is CONTEST rather than REJECT. The author should either wire at least the well-defined stages into strict-capable schemas and emit the correlation tag to an actual artifact, or explicitly document why these are deferred.

### AR-01: Feature 2 is dormant: no production stage schema is strict-capable, so constrainedSampling never attaches

- **Severity**: medium
- **Lens**: Architect
isStrictCapable() requires `additionalProperties === false`, but every STAGE_MODELS[*].schema is built with plain `Type.Object({...})` (e.g. DesignData, CodeReviewData, AdversarialReviewData, ImplementationSummaryData) that never sets additionalProperties:false (TypeBox omits the key, so it is undefined). isStrictCapable therefore returns false for ALL of them, and structuredOutputTool attaches `constrainedSampling` to none. The strict-capable variant `strictControlSchema()` is exported but invoked ONLY by tests/session-agent-constrained-sampling.test.ts — zero production callers. Net effect: on a capable provider, NO stage gets strict:"prefer", the model is never forced to fill all keys, and the corrective re-prompt fires exactly as before. The headline acceptance criterion ("a stage with a well-defined required-key schema gets strict:prefer and the model is forced to fill all keys") is satisfied only by a synthetic test schema, not by any real pipeline stage. This is the highest-leverage promise of Feature 2 and it is unrealized. Fix: either add `{ additionalProperties: false }` to the well-defined stage schemas (they already have required keys) or wrap STAGE_MODELS[*].schema through a strict-capable builder at the common-object seam in workflow.ts. Byte-identical to today (no regression), hence CONTEST not REJECT.
### AR-02: Feature 4's correlation tag is write-only: BuildGateResult.correlation is populated but consumed/serialized nowhere

- **Severity**: medium
- **Lens**: Architect
runBuildGate defensively reads PI_SESSION_ID/PI_MODEL and stamps a `correlation` field onto BuildGateResult, but grep shows the ONLY readers are in tests/build-runner-correlation.test.ts. The three production callers (src/stages/index.ts:53, src/stages/implementation.ts:306, src/stages/verify.ts:87) consume the result for pass/fail + feedback and never touch `.correlation`, and BuildGateResult is never serialized to a build-log header line or a structured trace artifact. The CHANGELOG even asserts it "stamps a plain-ASCII `# pi-session=<id> model=<model>` correlation tag into the captured build-run metadata" — that header line does not exist anywhere; only the in-memory field does. For an observability-only feature whose entire purpose is correlating parallel runs, shipping it with no emission path means it delivers zero observability: the data is captured and then discarded. Fix: actually emit the tag (a header line in the captured build log that the gate already accumulates, or serialize correlation into the change-tracker/trace).
### AR-03: New per-spawn ModelRuntime.create() + catalog lookup now runs on the session-backend hot path

- **Severity**: low
- **Lens**: Skeptic
Before this change, createAgentSession never received a `model` option. With Feature 1 defaulting to ctx.model (almost always present in a TUI session), resolveSessionModel() now runs on essentially EVERY session-backend specialist spawn, doing an async ModelRuntime.create() + runtime.getModel(provider, modelId). It is correctly try/catch-guarded (no throw), but the latency/caching behavior of ModelRuntime.create() is unverified (UNCERTAIN) — if it is not cached, every spawn pays a new async catalog-resolution cost it never paid before. Worth confirming ModelRuntime.create() is cheap/cached, or memoizing the resolved Model across a run.
### AR-04: Bare-id model ref (no slash) yields a degenerate provider==id descriptor on the fallback path

- **Severity**: low
- **Lens**: Skeptic
splitModelRef("claude-opus") returns { provider:"claude-opus", modelId:"" }. When ModelRuntime.create() throws (older/mocked runtime), resolveSessionModel's catch path returns `{ id: modelId || id, provider }` = { id:"claude-opus", provider:"claude-opus" }. That is a malformed Model descriptor handed to createAgentSession. It is best-effort and the SDK is documented as "the authority" on whether the id resolves, but provider==id is a degenerate shape that could confuse resolution on some SDK paths. Minor: consider only emitting the descriptor when provider/modelId are both non-empty, else fall through to the SDK/settings default (undefined).
### AR-05: Redundant `thinking` and `thinkingLevel` aliases on the shared common object

- **Severity**: low
- **Lens**: Minimalist
realAgent's `common` sets BOTH `thinking: call.thinking` and `thinkingLevel: call.thinking` to the same value purely so the subprocess backend (reads opts.thinking) and session backend (reads opts.thinkingLevel) can share one object. Functionally fine, but the dual-field aliasing is a readability/maintenance trap (a future reader must know both are the same source). Consolidating to one field name (or a tiny comment) would reduce the cognitive load at this already-dense seam.
### AR-06: Comment density / cross-referencing noise in the added code

- **Severity**: low
- **Lens**: Minimalist
The diff is saturated with phase/AC/SCENARIO tags and multi-paragraph preambles (e.g. the SteerSink block at the top of session-agent.ts, which predates this change, plus the per-callout `// Phase N (Feature N / SCENARIO-xxx)` annotations on nearly every new line). Not a correctness issue and harmless to behavior, but it adds long-term maintenance noise and makes the diff harder to scan for the actual logic. Prefer keeping the durable WHY in a header comment and dropping per-line scenario breadcrumbs once the change lands.
