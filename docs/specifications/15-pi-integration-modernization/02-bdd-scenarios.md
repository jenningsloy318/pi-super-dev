# Behavior Scenarios: pi Integration Modernization — Model/Thinking Inheritance, Constrained Sampling, Typed Renderers & Build Tagging

- **Date**: 2025-01-01
- **Author**: super-dev:bdd-scenario-writer
- **Source**: docs/specifications/15-pi-integration-modernization/01-requirements.md
- **Total Scenarios**: 20

---
## Feature: Feature 1: Specialists inherit the main session's model + thinking level

### SCENARIO-001: Specialists inherit the live session's model and thinking level when no override is supplied

- **Acceptance Criteria**: AC-01
- **Priority**: critical

**Given** the main session is running on a specific model with a defined thinking level
**When** the super-dev pipeline is invoked without an explicit model or thinking parameter
**Then** the session's model and thinking level are captured and threaded through the pipeline options as default values before any specialist is spawned
**And** every spawned specialist receives the inherited model and inherited thinking as their defaults
**And** an explicit model parameter or a SUPER_DEV_MODEL / SUPER_DEV_THINKING environment override still takes precedence over the inherited values
### SCENARIO-002: An older or non-TUI context exposes no session model or thinking level

- **Acceptance Criteria**: AC-01
- **Priority**: high

**Given** the invoking context does not expose a session model or thinking level
**When** the super-dev pipeline is invoked
**Then** nothing throws and execution degrades to the current default behavior
**And** the pipeline proceeds with role-based defaults exactly as before
### SCENARIO-003: Model precedence is applied end-to-end across all resolution tiers

- **Acceptance Criteria**: AC-02
- **Priority**: critical

**Given** the four model resolution tiers are available
**When** a specialist's model is resolved
**Then** the resolved model follows the order: explicit parameter, then SUPER_DEV_MODEL environment, then the inherited session model, then the SDK or settings default
**And** a higher-priority tier always overrides a lower-priority tier
**And** the subprocess model flag is emitted only when a model is actually resolved
### SCENARIO-004: The subprocess model flag is emitted only when a model is resolved

- **Acceptance Criteria**: AC-02
- **Priority**: medium

**Given** no model resolves from any tier
**When** the subprocess backend builds its launch arguments
**Then** no model flag is pushed onto the argument list
**And** existing argument construction behavior is preserved unchanged
### SCENARIO-005: Thinking precedence honors a new inherited tier above the role default

- **Acceptance Criteria**: AC-03
- **Priority**: critical

**Given** the per-call, environment, inherited, and role-default thinking tiers are defined
**When** a specialist's thinking level is resolved
**Then** the resolved thinking level follows the order: per-call, then SUPER_DEV_THINKING environment, then the inherited session thinking level, then the role default
**And** the inherited thinking level flows from the workflow agent factory through to the spawned agent
### SCENARIO-006: An inherited thinking level at least as strong as the role default is applied when no higher override exists

- **Acceptance Criteria**: AC-05
- **Priority**: high

**Given** the main session carries an inherited thinking level and no per-call or environment override is supplied
**When** a specialist is spawned on either backend
**Then** the specialist uses the inherited model and a thinking level no lower than the role default would have been
**And** the inherited thinking level takes precedence over the role default
### SCENARIO-007: The session backend launches the agent with the resolved model and thinking level options

- **Acceptance Criteria**: AC-04
- **Priority**: critical

**Given** an explicit or inherited model and thinking level are available
**When** the session backend creates the agent session
**Then** the session is created with the resolved model and the thinking level supplied as creation options
**And** the existing post-creation thinking application is retained as a best-effort second line of defense
**And** the best-effort application is guarded so the thinking level is not applied twice
### SCENARIO-008: An inherited model identifier that cannot be resolved to a concrete model falls back gracefully

- **Acceptance Criteria**: AC-04
- **Priority**: medium

**Given** the inherited model identifier cannot be resolved into a concrete model
**When** the session backend resolves the model
**Then** resolution falls through to the SDK or settings default without throwing
**And** the run continues rather than aborting
## Feature: Feature 2: Constrained tool sampling for structured output

### SCENARIO-009: A strict-capable schema is recognized as eligible for constrained sampling

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** a schema object that declares at least one required non-optional key and disallows additional properties
**When** the strict-capability of the schema is evaluated
**Then** the schema is classified as strict-capable
### SCENARIO-010: Permissive and non-object schemas are classified as not strict-capable

- **Acceptance Criteria**: AC-06
- **Priority**: high

**Given** a schema that is all-optional, or allows additional properties, or is not an object schema
**When** the strict-capability of the schema is evaluated
**Then** the schema is classified as not strict-capable
**And** the existing permissive control schema (all-optional with additional properties allowed) is classified as not strict-capable
### SCENARIO-011: Constrained sampling is requested when a strict-capable schema is provided

- **Acceptance Criteria**: AC-07
- **Priority**: high

**Given** a strict-capable schema with well-defined required keys is supplied for a stage's structured output
**When** the structured-output tool is constructed
**Then** the tool is annotated to request strict JSON-schema constrained sampling on capable providers
**And** the annotation is typed against the tool-definition contract
**And** capable providers are forced to fill all required keys
### SCENARIO-012: Constrained sampling is never attached to a permissive schema

- **Acceptance Criteria**: AC-08
- **Priority**: high

**Given** a permissive or open schema where strict sampling is not applicable
**When** the structured-output tool is constructed
**Then** no constrained-sampling annotation is attached and behavior is byte-identical to today
### SCENARIO-013: The corrective re-prompt fallback remains for non-capable providers and permissive schemas

- **Acceptance Criteria**: AC-08
- **Priority**: medium

**Given** a non-capable provider or a permissive schema where strict sampling does not apply
**When** a structured output omits required keys
**Then** the existing missing-key detection issues a single corrective re-prompt turn
**And** the corrective machinery is preserved unchanged as the fallback path
## Feature: Feature 3: Remove the registerEntryRenderer capability cast

### SCENARIO-014: The entry renderer is registered through the typed public API

- **Acceptance Criteria**: AC-09
- **Priority**: medium

**Given** the extension is activated on a pi version that exposes the typed entry-renderer registration API
**When** activation registers the background-summary transcript card
**Then** the renderer is registered directly through the typed public API without any unsafe capability cast
**And** the durable background-summary transcript card still renders as before
### SCENARIO-015: A failure during renderer registration degrades gracefully

- **Acceptance Criteria**: AC-09
- **Priority**: low

**Given** registering the entry renderer raises an error
**When** activation runs
**Then** the best-effort guard swallows the error and activation continues without aborting the run
## Feature: Feature 4: Tag build runs with pi's bash session correlation variables

### SCENARIO-016: A build run records the session id and model when correlation variables are present

- **Acceptance Criteria**: AC-10
- **Priority**: medium

**Given** the session id and model correlation variables are present in the build-run environment
**When** the build gate captures a build run's log, trace, or artifact metadata
**Then** the captured metadata includes the session id and model for correlation
**And** the gate's pass or fail logic is unchanged
**And** the gate's command construction is unchanged
**And** no control characters are emitted in machine-readable output modes
### SCENARIO-017: A build run is byte-identical when correlation variables are absent

- **Acceptance Criteria**: AC-10
- **Priority**: medium

**Given** the session id and model correlation variables are absent from the environment
**When** the build gate captures a build run
**Then** the captured build run is byte-identical to today's behavior
## Feature: Feature 5: Documentation and verification

### SCENARIO-018: The changelog summarizes the modernization changes

- **Acceptance Criteria**: AC-11
- **Priority**: low

**Given** the work for Features 1 through 4 is complete
**When** the changelog is updated
**Then** an unreleased entry summarizes model and thinking inheritance, constrained sampling, the typed entry renderer, and build-run correlation tagging
**And** the entry notes that the dependency bump to the current pi version is already done
### SCENARIO-019: The project type-checks and the full test suite passes

- **Acceptance Criteria**: AC-12
- **Priority**: critical

**Given** the changes are applied against the current pi type surface
**When** strict type-checking and the full test suite are run
**Then** type-checking is strict-clean and every existing and newly added test passes
**And** no new unsafe casts are introduced
### SCENARIO-020: The no-throw, additive, and byte-clean contracts are preserved

- **Acceptance Criteria**: AC-12
- **Priority**: high

**Given** the modernization is complete
**When** the pipeline runs in print, json, rpc, or headless mode
**Then** machine-readable output remains byte-identical with no control characters
**And** inheritance never overrides an explicit user, LLM, or environment override
**And** every new code path degrades to current behavior on failure rather than aborting
---

## Traceability

- **AC-01**: Capture ctx.model?.id and ctx.thinkingLevel before runPipelineTask and thread as inherited defaults; never throw when undefined. → SCENARIO-001, SCENARIO-002
- **AC-02**: Model precedence: explicit param -> SUPER_DEV_MODEL env -> inherited ctx.model.id -> SDK/settings default; preserve --model-only-when-resolved. → SCENARIO-003, SCENARIO-004
- **AC-03**: Widen resolveThinking precedence to include the inherited tier above the role default; thread inheritedThinking through options. → SCENARIO-005, SCENARIO-006
- **AC-04**: createAgentSession receives resolved model and thinkingLevel as options; applyThinkingLevel retained and guarded against double-application. → SCENARIO-007, SCENARIO-008
- **AC-05**: Without explicit params, both backends use inherited model and a thinking level no lower than role default; inheritance tests added. → SCENARIO-006, SCENARIO-009
- **AC-06**: isStrictCapable helper returns true only for Object schemas with a required non-Optional key and additionalProperties:false. → SCENARIO-009, SCENARIO-010
- **AC-07**: structured_output sets constrainedSampling strict:'prefer' only for strict-capable schemas; permissive shape remains the fallback. → SCENARIO-011, SCENARIO-012
- **AC-08**: missingKeys corrective re-prompt preserved unchanged as the fallback for non-capable providers and permissive schemas. → SCENARIO-012, SCENARIO-013
- **AC-09**: Delete the registerEntryRenderer cast and call the typed public API; keep try/catch guard and transcript-card rendering. → SCENARIO-014, SCENARIO-015
- **AC-10**: Record PI_SESSION_ID/PI_MODEL in build-run metadata when present; byte-identical when absent; no gate logic changes. → SCENARIO-016, SCENARIO-017
- **AC-11**: Add a concise CHANGELOG [Unreleased] entry summarizing Features 1-4 and noting the dependency bump is done. → SCENARIO-018
- **AC-12**: Strict typecheck clean against 0.82.1 types and full vitest suite green (existing + new). → SCENARIO-019, SCENARIO-020

## Coverage Summary

- **Total Acceptance Criteria**: 12
- **Covered by Scenarios**: 12
- **Uncovered**: 0
- **Total Scenarios**: 20
